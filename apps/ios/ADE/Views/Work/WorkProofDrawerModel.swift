import Foundation

// MARK: - Drawer model

/// One entry in the Proof sheet: a single item, or a before/after pair that an
/// answer's ```proof-compare block names. Mirrors `ProofDrawerItem` in
/// proofDrawerModel.ts.
enum WorkProofDrawerItem: Identifiable, Equatable {
  case single(ComputerUseArtifactSummary)
  case pair(before: ComputerUseArtifactSummary, after: ComputerUseArtifactSummary, caption: String)

  var id: String {
    switch self {
    case .single(let artifact): return artifact.id
    case .pair(let before, let after, _): return "\(before.id):\(after.id)"
    }
  }
}

/// The proof one turn filed, under its prompt; what its answer showed first.
struct WorkProofDrawerGroup: Identifiable, Equatable {
  let id: String
  let turnId: String?
  let prompt: String?
  let at: String
  let inAnswer: [WorkProofDrawerItem]
  let other: [WorkProofDrawerItem]
}

enum WorkProofMediaFilter: String, CaseIterable, Identifiable {
  case all = "All"
  case pictures = "Pictures"
  case videos = "Videos"
  var id: String { rawValue }
}

private let workProofCitationInTextPattern = try! NSRegularExpression(
  pattern: #"!\[[^\]]*\]\(\s*<?(ade-proof:[^)\s>]+)"#,
  options: [.caseInsensitive]
)
private let workProofCompareFencePattern = try! NSRegularExpression(
  pattern: #"```proof-compare[^\n]*\n([\s\S]*?)```"#,
  options: [.caseInsensitive]
)

private let workProofCodeFencePattern = try! NSRegularExpression(
  pattern: #"(^|\n)(```|~~~)([^\n]*)\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)"#
)
private let workProofInlineCodePattern = try! NSRegularExpression(pattern: #"(?<!`)`[^`\n]+`(?!`)"#)

/// The text with code removed: fenced blocks other than ```proof-compare and
/// inline code spans. A citation shown as an example inside code is not proof.
/// Mirrors `withoutCode` in proofCitation.ts.
private func workProofTextWithoutCode(_ text: String) -> String {
  let ns = text as NSString
  var result = ""
  var cursor = 0
  for match in workProofCodeFencePattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
    result += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
    let info = ns.substring(with: match.range(at: 3)).trimmingCharacters(in: .whitespaces).lowercased()
    result += info.hasPrefix("proof-compare") ? ns.substring(with: match.range) : ns.substring(with: match.range(at: 1))
    cursor = match.range.location + match.range.length
  }
  result += ns.substring(from: cursor)
  return workProofInlineCodePattern.stringByReplacingMatches(
    in: result,
    range: NSRange(location: 0, length: (result as NSString).length),
    withTemplate: ""
  )
}

/// Every artifact id a text cites, without repeats. Mirrors
/// `citedProofArtifactIds`.
func workCitedProofArtifactIds(_ answer: String) -> [String] {
  guard answer.localizedCaseInsensitiveContains("ade-proof") || answer.localizedCaseInsensitiveContains("proof-compare") else { return [] }
  let text = workProofTextWithoutCode(answer)
  var ids: [String] = []
  func add(_ id: String?) {
    if let id, !ids.contains(id) { ids.append(id) }
  }
  let range = NSRange(text.startIndex..., in: text)
  for match in workProofCitationInTextPattern.matches(in: text, range: range) {
    if let tokenRange = Range(match.range(at: 1), in: text) {
      add(workProofArtifactId(fromToken: String(text[tokenRange])))
    }
  }
  for compare in workProofCompareBlocks(text) {
    add(compare.before.artifactId)
    add(compare.after.artifactId)
  }
  return ids
}

func workProofCompareBlocks(_ text: String) -> [WorkProofCompare] {
  guard text.localizedCaseInsensitiveContains("proof-compare") else { return [] }
  let range = NSRange(text.startIndex..., in: text)
  return workProofCompareFencePattern.matches(in: text, range: range).compactMap { match in
    Range(match.range(at: 1), in: text).flatMap { workParseProofCompare(String(text[$0])) }
  }
}

private struct WorkProofTurn {
  let turnId: String
  let prompt: String?
  let startedAt: String
  var answerText: String
}

private func workProofEventTurnId(_ event: WorkChatEvent) -> String? {
  switch event {
  case .userMessage(_, _, let turnId, _, _, _): return turnId
  case .assistantText(_, let turnId, _): return turnId
  case .done(_, _, _, let turnId, _, _, _): return turnId
  case .toolCall(_, _, _, _, let turnId): return turnId
  case .toolResult(_, _, _, _, let turnId, _, _, _): return turnId
  case .activity(_, _, let turnId): return turnId
  case .status(_, _, let turnId): return turnId
  default: return nil
  }
}

private func workProofArtifactTurnId(_ artifact: ComputerUseArtifactSummary) -> String? {
  guard let data = artifact.metadataJson?.data(using: .utf8),
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let turnId = object["turnId"] as? String, !turnId.isEmpty else { return nil }
  return turnId
}

/// Groups a chat's proof by the turn that filed it, newest turn first. Mirrors
/// `buildProofDrawerGroups` in proofDrawerModel.ts.
func workProofDrawerGroups(
  artifacts: [ComputerUseArtifactSummary],
  transcript: [WorkChatEnvelope],
  query: String = "",
  media: WorkProofMediaFilter = .all,
  inAnswerOnly: Bool = false
) -> [WorkProofDrawerGroup] {
  var turns: [WorkProofTurn] = []
  var turnIndex: [String: Int] = [:]
  var pendingPrompt: String?
  for envelope in transcript {
    if case .userMessage(let text, _, _, _, _, _) = envelope.event {
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty { pendingPrompt = trimmed }
    }
    guard let turnId = workProofEventTurnId(envelope.event), !turnId.isEmpty else { continue }
    if turnIndex[turnId] == nil {
      turnIndex[turnId] = turns.count
      turns.append(WorkProofTurn(turnId: turnId, prompt: pendingPrompt, startedAt: envelope.timestamp, answerText: ""))
      pendingPrompt = nil
    }
    if case .assistantText(let text, _, _) = envelope.event, let index = turnIndex[turnId] {
      turns[index].answerText += text
    }
  }
  let citedByTurn = Dictionary(uniqueKeysWithValues: turns.map { ($0.turnId, workCitedProofArtifactIds($0.answerText)) })
  let citedAnywhere = Set(citedByTurn.values.flatMap { $0 })
  let pairs = turns.flatMap { workProofCompareBlocks($0.answerText) }

  let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  func matches(_ artifact: ComputerUseArtifactSummary) -> Bool {
    let video = workArtifactIsVideo(artifact)
    switch media {
    case .all: break
    case .videos: if !video { return false }
    case .pictures: if video || artifact.artifactKind != "screenshot" && !(artifact.mimeType ?? "").hasPrefix("image/") { return false }
    }
    if inAnswerOnly && !citedAnywhere.contains(artifact.id) { return false }
    guard !needle.isEmpty else { return true }
    return artifact.title.lowercased().contains(needle) || (artifact.description ?? "").lowercased().contains(needle)
  }

  func place(_ artifact: ComputerUseArtifactSummary) -> WorkProofTurn? {
    if let stamped = workProofArtifactTurnId(artifact) {
      return turnIndex[stamped].map { turns[$0] }
    }
    guard let at = workParsedDate(artifact.createdAt) else { return nil }
    var placed: WorkProofTurn?
    for turn in turns {
      guard let start = workParsedDate(turn.startedAt), start <= at else { break }
      placed = turn
    }
    return placed
  }

  func items(_ list: [ComputerUseArtifactSummary]) -> [WorkProofDrawerItem] {
    let byId = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    var used = Set<String>()
    var result: [WorkProofDrawerItem] = []
    for artifact in list where !used.contains(artifact.id) {
      if let pair = pairs.first(where: {
        ($0.before.artifactId == artifact.id || $0.after.artifactId == artifact.id)
          && $0.before.artifactId != $0.after.artifactId
          && byId[$0.before.artifactId] != nil && byId[$0.after.artifactId] != nil
          && !used.contains($0.before.artifactId) && !used.contains($0.after.artifactId)
      }), let before = byId[pair.before.artifactId], let after = byId[pair.after.artifactId] {
        used.insert(before.id)
        used.insert(after.id)
        result.append(.pair(before: before, after: after, caption: pair.caption))
        continue
      }
      used.insert(artifact.id)
      result.append(.single(artifact))
    }
    return result
  }

  var order: [String] = []
  var buckets: [String: (turn: WorkProofTurn?, artifacts: [ComputerUseArtifactSummary])] = [:]
  // One row per artifact: the host list can repeat an artifact once per owner link.
  var seen = Set<String>()
  for artifact in artifacts.sorted(by: { $0.createdAt < $1.createdAt }) where seen.insert(artifact.id).inserted && matches(artifact) {
    let turn = place(artifact)
    let key = turn.map { "turn:\($0.turnId)" } ?? "earlier"
    if buckets[key] == nil {
      buckets[key] = (turn, [])
      order.append(key)
    }
    buckets[key]?.artifacts.append(artifact)
  }

  let groups: [WorkProofDrawerGroup] = order.compactMap { key in
    guard let bucket = buckets[key], let first = bucket.artifacts.first else { return nil }
    let citedHere = bucket.turn.flatMap { citedByTurn[$0.turnId] } ?? []
    let inAnswer = bucket.artifacts
      .filter { citedAnywhere.contains($0.id) }
      .sorted { (citedHere.firstIndex(of: $0.id) ?? .max) < (citedHere.firstIndex(of: $1.id) ?? .max) }
    let other = bucket.artifacts.filter { !citedAnywhere.contains($0.id) }
    return WorkProofDrawerGroup(
      id: key,
      turnId: bucket.turn?.turnId,
      prompt: bucket.turn?.prompt,
      at: bucket.turn?.startedAt ?? first.createdAt,
      inAnswer: items(inAnswer),
      other: items(other)
    )
  }
  return groups.sorted { left, right in
    if left.id == "earlier" { return false }
    if right.id == "earlier" { return true }
    return left.at > right.at
  }
}
