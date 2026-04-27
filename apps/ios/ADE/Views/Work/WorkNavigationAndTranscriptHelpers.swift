import SwiftUI
import UIKit
import AVKit

struct WorkTerminalDisplay {
  let text: String
  let attributedText: AttributedString
  let truncated: Bool
}

private let workTerminalDisplayMaxCharacters = 24_000

func workTerminalDisplay(raw: String?, fallback: String?) -> WorkTerminalDisplay {
  let source = (raw?.isEmpty == false ? raw : fallback) ?? "No output yet."
  let replay = WorkTerminalTextReplay()
  replay.write(source)
  let replayText = replay.text
  let sanitized = collapseDuplicatedWorkStreamTextIfNeeded(replayText)
  guard sanitized.count > workTerminalDisplayMaxCharacters else {
    return WorkTerminalDisplay(
      text: sanitized,
      attributedText: sanitized == replayText ? replay.attributedText() : workTerminalPlainAttributedString(sanitized),
      truncated: false
    )
  }
  let displayText = String(sanitized.suffix(workTerminalDisplayMaxCharacters))
  return WorkTerminalDisplay(
    text: displayText,
    attributedText: workTerminalPlainAttributedString(displayText),
    truncated: true
  )
}

func sanitizeTerminalOutputForDisplay(_ input: String) -> String {
  let screen = WorkTerminalTextReplay()
  screen.write(input)
  return collapseDuplicatedWorkStreamTextIfNeeded(screen.text)
}

private final class WorkTerminalTextReplay {
  private var lines: [[WorkTerminalCell]] = [[]]
  private var row = 0
  private var column = 0
  private var foreground: WorkANSIColor?
  private var bold = false

  var text: String {
    renderedLines()
      .map { String(String.UnicodeScalarView($0.map(\.scalar))) }
      .joined(separator: "\n")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func attributedText() -> AttributedString {
    let renderedLines = renderedLines(trimEmptyEdges: true)
    guard !renderedLines.isEmpty else {
      return workTerminalPlainAttributedString("")
    }

    var attributed = AttributedString("")
    for lineIndex in renderedLines.indices {
      if lineIndex > renderedLines.startIndex {
        attributed.append(workTerminalPlainAttributedString("\n"))
      }
      attributed.append(attributedLine(renderedLines[lineIndex]))
    }
    return attributed
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
  }

  private func put(_ scalar: UnicodeScalar) {
    ensureCursor()
    while lines[row].count < column {
      lines[row].append(WorkTerminalCell(scalar: " "))
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
      lines = [[]]
      row = 0
      column = 0
      foreground = nil
      bold = false
    case "(", ")", "*", "+":
      if index < scalars.endIndex {
        index = scalars.index(after: index)
      }
    default:
      break
    }
  }

  private func consumeOSC(in scalars: [UnicodeScalar], index: inout Int) {
    while index < scalars.endIndex {
      let current = scalars[index]
      index = scalars.index(after: index)
      if current == "\u{0007}" {
        break
      }
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
    let params = body
      .split(separator: ";", omittingEmptySubsequences: false)
      .map { Int(String($0).trimmingCharacters(in: CharacterSet(charactersIn: "?"))) ?? 0 }
    let first = params.first ?? 0

    switch command {
    case "A":
      row = max(0, row - max(1, first))
    case "B":
      row += max(1, first)
      ensureCursor()
    case "C":
      column += max(1, first)
    case "D":
      column = max(0, column - max(1, first))
    case "G":
      column = max(0, max(1, first) - 1)
    case "H", "f":
      row = max(0, max(1, first) - 1)
      column = max(0, max(1, params.dropFirst().first ?? 1) - 1)
      ensureCursor()
    case "J":
      if first == 2 || first == 3 {
        lines = [[]]
        row = 0
        column = 0
      }
    case "K":
      ensureCursor()
      if first == 1 {
        let space = WorkTerminalCell(scalar: " ")
        let endIndex = min(column + 1, lines[row].count)
        for index in 0..<endIndex {
          lines[row][index] = space
        }
        if column >= lines[row].count {
          while lines[row].count <= column {
            lines[row].append(space)
          }
        }
      } else if first == 2 {
        lines[row].removeAll()
        column = 0
      } else if column < lines[row].count {
        lines[row].removeSubrange(column..<lines[row].count)
      }
    case "m":
      applySGR(params)
    default:
      break
    }
  }

  private func applySGR(_ rawParams: [Int]) {
    let params = rawParams.isEmpty ? [0] : rawParams
    var index = params.startIndex
    while index < params.endIndex {
      let code = params[index]
      switch code {
      case 0:
        foreground = nil
        bold = false
      case 1:
        bold = true
      case 22:
        bold = false
      case 30, 90:
        foreground = .black
      case 31, 91:
        foreground = .red
      case 32, 92:
        foreground = .green
      case 33, 93:
        foreground = .yellow
      case 34, 94:
        foreground = .blue
      case 35, 95:
        foreground = .magenta
      case 36, 96:
        foreground = .cyan
      case 37, 97:
        foreground = .white
      case 38:
        if index + 2 < params.endIndex, params[index + 1] == 5 {
          foreground = workTerminalANSI256Color(params[index + 2])
          index += 2
        } else if index + 4 < params.endIndex, params[index + 1] == 2 {
          foreground = workTerminalRGBColor(red: params[index + 2], green: params[index + 3], blue: params[index + 4])
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

  private func renderedLines(trimEmptyEdges: Bool = false) -> [[WorkTerminalCell]] {
    var rendered = lines.map { line in
      var trimmed = line
      while let last = trimmed.last, CharacterSet.whitespaces.contains(last.scalar) {
        trimmed.removeLast()
      }
      return trimmed
    }

    if trimEmptyEdges {
      while rendered.first?.isEmpty == true {
        rendered.removeFirst()
      }
      while rendered.last?.isEmpty == true {
        rendered.removeLast()
      }
    }
    return rendered
  }

  private func attributedLine(_ line: [WorkTerminalCell]) -> AttributedString {
    var attributed = AttributedString("")
    var index = line.startIndex
    while index < line.endIndex {
      let start = index
      let style = line[start].style
      index = line.index(after: index)
      while index < line.endIndex, line[index].style == style {
        index = line.index(after: index)
      }
      let text = String(String.UnicodeScalarView(line[start..<index].map(\.scalar)))
      attributed.append(workTerminalAttributedString(text, foreground: style.foreground, bold: style.bold))
    }
    return attributed
  }
}

private struct WorkTerminalCell {
  let scalar: UnicodeScalar
  let foreground: WorkANSIColor?
  let bold: Bool

  init(scalar: UnicodeScalar, foreground: WorkANSIColor? = nil, bold: Bool = false) {
    self.scalar = scalar
    self.foreground = foreground
    self.bold = bold
  }

  var style: WorkTerminalCellStyle {
    WorkTerminalCellStyle(foreground: foreground, bold: bold)
  }
}

private struct WorkTerminalCellStyle: Equatable {
  let foreground: WorkANSIColor?
  let bold: Bool
}

func workTerminalPlainAttributedString(_ text: String, fontSize: CGFloat = 12) -> AttributedString {
  workTerminalAttributedString(text, foreground: nil, bold: false, fontSize: fontSize)
}

private func workTerminalAttributedString(
  _ text: String,
  foreground: WorkANSIColor?,
  bold: Bool,
  fontSize: CGFloat = 12
) -> AttributedString {
  var attributed = AttributedString(text)
  attributed.font = .system(size: fontSize, weight: bold ? .semibold : .regular, design: .monospaced)
  attributed.foregroundColor = workTerminalForegroundColor(foreground)
  return attributed
}

private func workTerminalForegroundColor(_ color: WorkANSIColor?) -> Color {
  switch color {
  case .red: return .red
  case .green: return .green
  case .yellow: return .yellow
  case .blue: return .blue
  case .magenta: return .purple
  case .cyan: return .cyan
  case .white: return .white
  case .black: return ADEColor.textMuted
  case .none: return ADEColor.textPrimary
  }
}

private func workTerminalANSI256Color(_ code: Int) -> WorkANSIColor? {
  switch code {
  case 0, 8: return .black
  case 1, 9: return .red
  case 2, 10: return .green
  case 3, 11: return .yellow
  case 4, 12: return .blue
  case 5, 13: return .magenta
  case 6, 14: return .cyan
  case 7, 15: return .white
  case 16...231:
    let value = code - 16
    let red = value / 36
    let green = (value / 6) % 6
    let blue = value % 6
    return workTerminalRGBColor(red: red * 51, green: green * 51, blue: blue * 51)
  case 232...255:
    return code >= 244 ? .white : .black
  default:
    return nil
  }
}

private func workTerminalRGBColor(red: Int, green: Int, blue: Int) -> WorkANSIColor? {
  let red = max(0, min(255, red))
  let green = max(0, min(255, green))
  let blue = max(0, min(255, blue))
  let maxChannel = max(red, green, blue)
  let minChannel = min(red, green, blue)
  guard maxChannel >= 80 else { return .black }
  if maxChannel - minChannel < 32 {
    return maxChannel > 180 ? .white : nil
  }
  if red == maxChannel && green == maxChannel { return .yellow }
  if green == maxChannel && blue == maxChannel { return .cyan }
  if red == maxChannel && blue == maxChannel { return .magenta }
  if red == maxChannel { return .red }
  if green == maxChannel { return .green }
  return .blue
}

private extension String {
  func trimmingTrailingTerminalPadding() -> String {
    var result = self
    while let last = result.unicodeScalars.last, CharacterSet.whitespaces.contains(last) {
      result.removeLast()
    }
    return result
  }
}

func collapseDuplicatedWorkStreamTextIfNeeded(_ input: String) -> String {
  let scalars = Array(input.unicodeScalars)
  guard scalars.count >= 12 else { return input }

  func collapsedRun(_ run: ArraySlice<UnicodeScalar>) -> [UnicodeScalar] {
    guard run.count >= 4 else { return Array(run) }
    var duplicatePairs = 0
    var segments = 0
    var singletonSegments = 0
    var hasLongDuplicateSegment = false
    var previous: UnicodeScalar?
    var currentSegmentLength = 0

    func finishSegment() {
      guard currentSegmentLength > 0 else { return }
      segments += 1
      if currentSegmentLength == 1 {
        singletonSegments += 1
      }
      if currentSegmentLength >= 3 {
        hasLongDuplicateSegment = true
      }
    }

    for scalar in run {
      if let previous, scalar != previous {
        finishSegment()
        currentSegmentLength = 0
      }
      if scalar == previous {
        duplicatePairs += 1
      }
      currentSegmentLength += 1
      previous = scalar
    }
    finishSegment()

    let density = Double(duplicatePairs) / Double(max(run.count - 1, 1))
    let mostlyDuplicated = singletonSegments == 0 || singletonSegments <= max(1, segments / 4)
    guard duplicatePairs >= 2, density >= 0.3, mostlyDuplicated || hasLongDuplicateSegment else { return Array(run) }

    var collapsed: [UnicodeScalar] = []
    var index = run.startIndex
    while index < run.endIndex {
      let scalar = run[index]
      var runEnd = run.index(after: index)
      while runEnd < run.endIndex, run[runEnd] == scalar {
        runEnd = run.index(after: runEnd)
      }
      let runLength = run.distance(from: index, to: runEnd)
      let collapsedLength = max(1, (runLength + 1) / 2)
      collapsed.append(contentsOf: Array(repeating: scalar, count: collapsedLength))
      index = runEnd
    }
    return collapsed
  }

  var locallyCollapsed = String.UnicodeScalarView()
  locallyCollapsed.reserveCapacity(input.unicodeScalars.count)
  var runStart: Int?
  for index in scalars.indices {
    if CharacterSet.alphanumerics.contains(scalars[index]) {
      if runStart == nil {
        runStart = index
      }
      continue
    }
    if let start = runStart {
      locallyCollapsed.append(contentsOf: collapsedRun(scalars[start..<index]))
      runStart = nil
    }
    locallyCollapsed.append(scalars[index])
  }
  if let start = runStart {
    locallyCollapsed.append(contentsOf: collapsedRun(scalars[start..<scalars.endIndex]))
  }
  let localResult = String(locallyCollapsed)
  if localResult != input {
    return collapseDuplicatedStreamPunctuation(in: localResult)
  }

  var comparablePairs = 0
  var duplicatedAlphanumericPairs = 0
  for index in scalars.indices.dropFirst() {
    let scalar = scalars[index]
    guard CharacterSet.alphanumerics.contains(scalar) else { continue }
    comparablePairs += 1
    if scalar == scalars[index - 1] {
      duplicatedAlphanumericPairs += 1
    }
  }

  guard duplicatedAlphanumericPairs >= 5 else { return input }
  let density = Double(duplicatedAlphanumericPairs) / Double(max(comparablePairs, 1))
  guard density >= 0.32 else { return input }

  var collapsed = String.UnicodeScalarView()
  collapsed.reserveCapacity(input.unicodeScalars.count)
  var index = scalars.startIndex
  while index < scalars.endIndex {
    let scalar = scalars[index]
    guard CharacterSet.alphanumerics.contains(scalar) else {
      collapsed.append(scalar)
      index = scalars.index(after: index)
      continue
    }

    var runEnd = scalars.index(after: index)
    while runEnd < scalars.endIndex, scalars[runEnd] == scalar {
      runEnd = scalars.index(after: runEnd)
    }
    let runLength = scalars.distance(from: index, to: runEnd)
    let collapsedLength = max(1, (runLength + 1) / 2)
    for _ in 0..<collapsedLength {
      collapsed.append(scalar)
    }
    index = runEnd
  }
  return String(collapsed)
}

private func collapseDuplicatedStreamPunctuation(in input: String) -> String {
  let duplicatedPunctuation = CharacterSet(charactersIn: ",.;:!?")
  let scalars = Array(input.unicodeScalars)
  var collapsed = String.UnicodeScalarView()
  collapsed.reserveCapacity(input.unicodeScalars.count)
  var index = scalars.startIndex
  while index < scalars.endIndex {
    let scalar = scalars[index]
    guard duplicatedPunctuation.contains(scalar) else {
      collapsed.append(scalar)
      index = scalars.index(after: index)
      continue
    }
    var runEnd = scalars.index(after: index)
    while runEnd < scalars.endIndex, scalars[runEnd] == scalar {
      runEnd = scalars.index(after: runEnd)
    }
    let runLength = scalars.distance(from: index, to: runEnd)
    // Preserve ellipses: a 3-dot run is a legitimate "..." the user typed; only halve
    // dot-runs of 4+, which are the ones that came from streaming duplication.
    let shouldHalve = scalar == "." ? runLength >= 4 : runLength >= 2
    let collapsedLength = shouldHalve ? max(1, (runLength + 1) / 2) : runLength
    collapsed.append(contentsOf: Array(repeating: scalar, count: collapsedLength))
    index = runEnd
  }
  return String(collapsed)
}

func workSessionPreviewText(_ rawPreview: String?) -> String? {
  guard let rawPreview else { return nil }
  let trimmed = collapseDuplicatedWorkStreamTextIfNeeded(rawPreview)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}

func extractWorkNavigationTargets(from text: String) -> WorkNavigationTargets {
  let filePattern = #"(?<![A-Za-z0-9_])(?:\.{1,2}/)?(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\.(?:swift|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|json|yaml|yml|toml|md|mdx|txt|html|css|scss|sql|sh|bash|zsh|plist|png|jpg|jpeg|gif|webp|svg)(?::\d+)?"#
  let prPattern = #"(?<![A-Za-z0-9])#(\d+)\b"#

  var filePaths: [String] = []
  var seenFiles = Set<String>()
  for match in workRegexMatches(pattern: filePattern, in: text) {
    guard let normalized = normalizedWorkReferenceFilePath(match), seenFiles.insert(normalized).inserted else { continue }
    filePaths.append(normalized)
  }

  var pullRequestNumbers: [Int] = []
  var seenPullRequests = Set<Int>()
  for match in workRegexMatches(pattern: prPattern, in: text) {
    guard let number = Int(match.dropFirst()), seenPullRequests.insert(number).inserted else { continue }
    pullRequestNumbers.append(number)
  }

  return WorkNavigationTargets(filePaths: filePaths, pullRequestNumbers: pullRequestNumbers)
}

func workRegexMatches(pattern: String, in text: String) -> [String] {
  guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
  let range = NSRange(location: 0, length: (text as NSString).length)
  return regex.matches(in: text, range: range).compactMap { match in
    Range(match.range, in: text).map { String(text[$0]) }
  }
}

func normalizedWorkReferenceFilePath(_ rawPath: String) -> String? {
  var candidate = rawPath.trimmingCharacters(in: CharacterSet(charactersIn: "\"'`()[]{}<>,"))
  guard !candidate.isEmpty else { return nil }
  guard !candidate.contains("://") else { return nil }

  if let lineNumberRange = candidate.range(of: #":\d+$"#, options: .regularExpression) {
    candidate.removeSubrange(lineNumberRange)
  }

  if candidate.hasPrefix("./") {
    candidate.removeFirst(2)
  }

  guard !candidate.hasPrefix("../") else { return nil }
  return candidate
}

func normalizeWorkFileReference(_ rawPath: String, workspaceRoot: String, requestedCwd: String? = nil) -> String {
  guard let normalized = normalizedWorkReferenceFilePath(rawPath) else { return "" }
  let root = workspaceRoot.hasSuffix("/") ? String(workspaceRoot.dropLast()) : workspaceRoot

  func normalizedRequestedCwdPath() -> String? {
    guard let requestedCwd else { return nil }
    let trimmed = requestedCwd.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if trimmed.hasPrefix(root + "/") {
      return String(trimmed.dropFirst(root.count + 1))
    }
    if trimmed.hasPrefix("/") {
      return nil
    }
    return trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  }

  if normalized.hasPrefix(root + "/") {
    return String(normalized.dropFirst(root.count + 1))
  }

  if normalized.hasPrefix("/") {
    return ""
  }

  if let requestedCwdPath = normalizedRequestedCwdPath(), !requestedCwdPath.isEmpty {
    let baseURL = URL(fileURLWithPath: requestedCwdPath, isDirectory: true)
    let resolvedURL = baseURL.appendingPathComponent(normalized).standardizedFileURL
    let resolvedPath = resolvedURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if resolvedPath.isEmpty || resolvedPath.hasPrefix("../") || resolvedPath.contains("/../") {
      return ""
    }
    return resolvedPath
  }

  return normalized
}

func workReferenceLabel(for path: String) -> String {
  let normalized = normalizedWorkReferenceFilePath(path) ?? path
  let lastComponent = (normalized as NSString).lastPathComponent
  return lastComponent.isEmpty ? normalized : lastComponent
}

func buildWorkToolCards(
  from transcript: [WorkChatEnvelope],
  suppressedPendingItemIds: Set<String> = []
) -> [WorkToolCardModel] {
  var cards: [String: WorkToolCardModel] = [:]
  var orderedIds: [String] = []
  func resolveToolName(_ existing: String?, _ incoming: String) -> String {
    let trimmedExisting = existing?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !trimmedExisting.isEmpty { return existing! }
    let trimmedIncoming = incoming.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmedIncoming.isEmpty { return incoming }
    // Last-resort placeholder so `toolDisplayName(_:)` produces the readable
    // "Tool" fallback rather than a blank-looking row when the SDK emitted no
    // tool name on either the call or the result.
    return "tool"
  }

  for envelope in transcript {
    switch envelope.event {
    case .toolCall(let tool, let argsText, let itemId, _, _):
      if suppressedPendingItemIds.contains(itemId) {
        continue
      }
      if isQuestionInputToolName(tool),
         pendingWorkQuestionFromAskUserToolCall(argsText: argsText, itemId: itemId) != nil {
        continue
      }
      if cards[itemId] == nil {
        orderedIds.append(itemId)
      }
      cards[itemId] = WorkToolCardModel(
        id: itemId,
        toolName: resolveToolName(cards[itemId]?.toolName, tool),
        status: .running,
        startedAt: envelope.timestamp,
        completedAt: nil,
        argsText: nonEmpty(argsText),
        resultText: cards[itemId]?.resultText
      )
    case .toolResult(let tool, let resultText, let itemId, _, _, let status):
      let existing = cards[itemId]
      if existing == nil {
        orderedIds.append(itemId)
      }
      cards[itemId] = WorkToolCardModel(
        id: itemId,
        toolName: resolveToolName(existing?.toolName, tool),
        status: status,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        completedAt: envelope.timestamp,
        argsText: existing?.argsText,
        resultText: nonEmpty(resultText)
      )
    default:
      continue
    }
  }

  return orderedIds.compactMap { cards[$0] }
}

func parseANSISegments(_ input: String) -> [ANSISegment] {
  var segments: [ANSISegment] = []
  var buffer = ""
  var foreground: WorkANSIColor?
  var bold = false
  var index = input.startIndex

  func flush() {
    guard !buffer.isEmpty else { return }
    segments.append(ANSISegment(text: buffer, foreground: foreground, bold: bold))
    buffer = ""
  }

  while index < input.endIndex {
    let character = input[index]
    if character == "\u{001B}" {
      let next = input.index(after: index)
      guard next < input.endIndex, input[next] == "[" else {
        index = next < input.endIndex ? input.index(after: next) : input.endIndex
        continue
      }
      var commandIndex = input.index(after: next)
      var finalCharacter: Character?
      while commandIndex < input.endIndex {
        let candidate = input[commandIndex]
        if let scalar = candidate.unicodeScalars.first,
           scalar.value >= 0x40 && scalar.value <= 0x7E {
          finalCharacter = candidate
          break
        }
        commandIndex = input.index(after: commandIndex)
      }
      guard let finalCharacter else {
        index = input.endIndex
        continue
      }
      guard finalCharacter == "m" else {
        index = input.index(after: commandIndex)
        continue
      }
      flush()
      let codeString = String(input[input.index(after: next)..<commandIndex])
      let codes = codeString.split(separator: ";").compactMap { Int($0) }
      if codes.isEmpty {
        foreground = nil
        bold = false
      }
      for code in codes {
        switch code {
        case 0:
          foreground = nil
          bold = false
        case 1:
          bold = true
        case 30, 90:
          foreground = .black
        case 31, 91:
          foreground = .red
        case 32, 92:
          foreground = .green
        case 33, 93:
          foreground = .yellow
        case 34, 94:
          foreground = .blue
        case 35, 95:
          foreground = .magenta
        case 36, 96:
          foreground = .cyan
        case 37, 97:
          foreground = .white
        case 39:
          foreground = nil
        case 22:
          bold = false
        default:
          continue
        }
      }
      index = input.index(after: commandIndex)
      continue
    }
    buffer.append(character)
    index = input.index(after: index)
  }

  flush()
  return segments
}
