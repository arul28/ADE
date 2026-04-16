import SwiftUI
import UIKit
import AVKit

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

func buildWorkToolCards(from transcript: [WorkChatEnvelope]) -> [WorkToolCardModel] {
  var cards: [String: WorkToolCardModel] = [:]
  var orderedIds: [String] = []

  for envelope in transcript {
    switch envelope.event {
    case .toolCall(let tool, let argsText, let itemId, _, _):
      if cards[itemId] == nil {
        orderedIds.append(itemId)
      }
      cards[itemId] = WorkToolCardModel(
        id: itemId,
        toolName: tool,
        status: .running,
        startedAt: envelope.timestamp,
        completedAt: nil,
        argsText: argsText,
        resultText: cards[itemId]?.resultText
      )
    case .toolResult(let tool, let resultText, let itemId, _, _, let status):
      let existing = cards[itemId]
      if existing == nil {
        orderedIds.append(itemId)
      }
      cards[itemId] = WorkToolCardModel(
        id: itemId,
        toolName: existing?.toolName ?? tool,
        status: status,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        completedAt: envelope.timestamp,
        argsText: existing?.argsText,
        resultText: resultText
      )
    default:
      continue
    }
  }

  return orderedIds.compactMap { cards[$0] }
}

func deriveWorkAgentActivities(from transcript: [WorkChatEnvelope], session: WorkAgentActivityContext) -> [WorkAgentActivity] {
  var activeSubagents: [String: WorkAgentActivity] = [:]
  let toolCards = buildWorkToolCards(from: transcript)
  let runningTool = toolCards.last(where: { $0.status == .running })

  for envelope in transcript {
    switch envelope.event {
    case .subagentStarted(let taskId, let description, _, _):
      activeSubagents[taskId] = WorkAgentActivity(
        sessionId: session.sessionId,
        taskId: taskId,
        agentName: description.isEmpty ? session.title : description,
        toolName: nil,
        laneName: session.laneName,
        startedAt: envelope.timestamp,
        detail: nil
      )
    case .subagentProgress(let taskId, let description, let summary, let toolName, _):
      let existing = activeSubagents[taskId]
      activeSubagents[taskId] = WorkAgentActivity(
        sessionId: session.sessionId,
        taskId: taskId,
        agentName: description ?? existing?.agentName ?? session.title,
        toolName: toolName ?? existing?.toolName,
        laneName: session.laneName,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        detail: summary
      )
    case .subagentResult(let taskId, _, _, _):
      activeSubagents.removeValue(forKey: taskId)
    default:
      continue
    }
  }

  let subagents = activeSubagents.values.sorted { $0.startedAt > $1.startedAt }
  if !subagents.isEmpty {
    return subagents
  }

  guard session.status == "active" else { return [] }
  let latestActivityDetail = transcript.reversed().compactMap { envelope -> String? in
    switch envelope.event {
    case .activity(_, let detail, _): return detail
    case .reasoning(let text, _): return text
    case .status(_, let message, _): return message
    default: return nil
    }
  }.first

  return [WorkAgentActivity(
    sessionId: session.sessionId,
    taskId: nil,
    agentName: session.title,
    toolName: runningTool?.toolName,
    laneName: session.laneName,
    startedAt: runningTool?.startedAt ?? session.startedAt,
    detail: latestActivityDetail
  )]
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
        buffer.append(character)
        index = input.index(after: index)
        continue
      }
      guard let commandIndex = input[next...].firstIndex(of: "m") else {
        break
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
