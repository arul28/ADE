import Foundation

struct WorkChatSourceList {
  let refs: [AgentChatSourceRef]
  let omittedCount: Int
  let countsByTurn: [String: Int]
}

private let workSourceTrackingParameter = try! NSRegularExpression(
  pattern: "^(?:utm_[a-z0-9_]*|fbclid|gclid|msclkid|yclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|ref_src|ref_url|amp)$",
  options: [.caseInsensitive]
)
private let workSourceReferralHostValue = try! NSRegularExpression(
  pattern: "^(?:[a-z0-9-]+\\.)+[a-z]{2,}$",
  options: [.caseInsensitive]
)
private let workSourceMirrorPrefix = try! NSRegularExpression(
  pattern: "^(?:www|m|mobile|amp)\\.",
  options: [.caseInsensitive]
)
private let workSourceLocaleMirrorPrefix = try! NSRegularExpression(
  pattern: "^([a-z]{2,3}(?:-[a-z]+)?)\\.m\\.",
  options: [.caseInsensitive]
)
private let workSourceProseUrl = try! NSRegularExpression(
  pattern: "https?://[^\\s<>\"'`]+",
  options: [.caseInsensitive]
)

private func workRegexMatches(_ regex: NSRegularExpression, _ value: String) -> Bool {
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  return regex.firstMatch(in: value, range: range) != nil
}

private func workDecodedQueryPart(_ value: String) -> String {
  value.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? value
}

/// Matches desktop's page identity rules so a mobile mirror, AMP page, or
/// tracked link does not inflate the source list or the per-turn source count.
func workNormalizeSourceUrl(_ rawValue: String?) -> String? {
  guard let raw = rawValue?.trimmingCharacters(in: .whitespacesAndNewlines),
        !raw.isEmpty,
        let components = URLComponents(string: raw),
        let scheme = components.scheme?.lowercased(),
        scheme == "http" || scheme == "https",
        components.user == nil,
        components.password == nil,
        var host = components.host?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")),
        !host.isEmpty else { return nil }

  let hostRange = NSRange(host.startIndex..<host.endIndex, in: host)
  if let match = workSourceMirrorPrefix.firstMatch(in: host, range: hostRange),
     let swiftRange = Range(match.range, in: host) {
    let candidate = String(host[swiftRange.upperBound...])
    if candidate.contains(".") { host = candidate }
  }
  let localeRange = NSRange(host.startIndex..<host.endIndex, in: host)
  if let match = workSourceLocaleMirrorPrefix.firstMatch(in: host, range: localeRange),
     match.numberOfRanges > 1,
     let localeRange = Range(match.range(at: 1), in: host),
     let matchRange = Range(match.range, in: host) {
    let candidate = String(host[localeRange]) + "." + String(host[matchRange.upperBound...])
    if candidate.contains(".") { host = candidate }
  }

  var normalized = components
  normalized.scheme = "https"
  normalized.host = host
  if components.port == 80 || components.port == 443 { normalized.port = nil }
  normalized.fragment = nil

  var path = components.percentEncodedPath
  while path.hasSuffix("/") { path.removeLast() }
  if path.lowercased().hasSuffix("/amp") {
    path.removeLast(4)
    while path.hasSuffix("/") { path.removeLast() }
  }
  normalized.percentEncodedPath = path

  let queryPairs = (components.percentEncodedQuery ?? "")
    .split(separator: "&", omittingEmptySubsequences: false)
    .map(String.init)
    .enumerated()
    .filter { _, pair in
      guard !pair.isEmpty else { return false }
      let pieces = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      let key = pieces.first.map(String.init) ?? ""
      let value = pieces.count > 1 ? String(pieces[1]) : ""
      let decodedKey = workDecodedQueryPart(key)
      if workRegexMatches(workSourceTrackingParameter, decodedKey) { return false }
      return !(decodedKey.lowercased() == "ref"
        && workRegexMatches(workSourceReferralHostValue, workDecodedQueryPart(value)))
    }
    .sorted(by: workSourceQueryPairPrecedes)
    .map(\.element)
  normalized.percentEncodedQuery = queryPairs.isEmpty ? nil : queryPairs.joined(separator: "&")
  return normalized.string
}

private func workSourceQueryKey(_ pair: String) -> String {
  pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
}

private func workSourceQueryPairPrecedes(
  _ left: (offset: Int, element: String),
  _ right: (offset: Int, element: String)
) -> Bool {
  let leftKey = workSourceQueryKey(left.element)
  let rightKey = workSourceQueryKey(right.element)
  return leftKey == rightKey ? left.offset < right.offset : leftKey < rightKey
}

func workChatSourceKey(_ ref: AgentChatSourceRef) -> String? {
  if let normalizedUrl = workNormalizeSourceUrl(ref.url) { return normalizedUrl }
  let path = ref.path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return path.isEmpty ? nil : "file:\(path)"
}

private func workLinkedSourceUrls(in prose: String) -> Set<String> {
  guard prose.range(of: "://") != nil else { return [] }
  var result = Set<String>()
  let range = NSRange(prose.startIndex..<prose.endIndex, in: prose)
  for match in workSourceProseUrl.matches(in: prose, range: range) {
    guard let swiftRange = Range(match.range, in: prose) else { continue }
    var candidate = String(prose[swiftRange])
    while let last = candidate.last, ".,;:!?*_~".contains(last) { candidate.removeLast() }
    let openParens = candidate.filter { $0 == "(" }.count
    let closeParens = candidate.filter { $0 == ")" }.count
    if closeParens > openParens, candidate.hasSuffix(")") { candidate.removeLast() }
    if let normalized = workNormalizeSourceUrl(candidate) { result.insert(normalized) }
  }
  return result
}

func buildWorkChatSourceList(from transcript: [WorkChatEnvelope]) -> WorkChatSourceList {
  var refs: [AgentChatSourceRef] = []
  var indexByKey: [String: Int] = [:]
  var seenKeys = Set<String>()
  var sourceKeysByTurn: [String: Set<String>] = [:]
  var allSourceKeysByTurn: [String: Set<String>] = [:]
  var omittedByTurn: [String: Int] = [:]
  var proseByMessage: [String: (turnId: String?, text: String)] = [:]
  var omittedCount = 0
  let maximum = 32
  let orderedTranscript = sortedWorkChatEnvelopes(transcript)
  for envelope in orderedTranscript {
    let eventRefs: [AgentChatSourceRef]
    let eventTurnId: String?
    let eventOmitted: Int
    switch envelope.event {
    case .sources(let sourceRefs, let turnId, let omitted):
      eventRefs = sourceRefs
      eventTurnId = normalizedWorkTurnId(turnId)
      eventOmitted = max(0, omitted ?? 0)
    case .toolResult(_, _, _, _, let turnId, _, let sourceRefs, let omitted):
      eventRefs = sourceRefs ?? []
      eventTurnId = normalizedWorkTurnId(turnId)
      eventOmitted = max(0, omitted ?? 0)
    default:
      continue
    }
    omittedCount += eventOmitted
    if let eventTurnId, eventOmitted > 0 {
      omittedByTurn[eventTurnId, default: 0] += eventOmitted
    }
    for ref in eventRefs {
      guard let key = workChatSourceKey(ref) else { continue }
      if let eventTurnId { allSourceKeysByTurn[eventTurnId, default: []].insert(key) }
      let visibleIndex: Int?
      if let existingIndex = indexByKey[key] {
        visibleIndex = existingIndex
        if ref.cited == true { refs[existingIndex].cited = true }
        if let title = ref.title, (refs[existingIndex].title?.count ?? 0) < title.count {
          refs[existingIndex].title = title
        }
      } else if seenKeys.insert(key).inserted {
        if refs.count < maximum {
          visibleIndex = refs.count
          indexByKey[key] = refs.count
          refs.append(ref)
        } else {
          visibleIndex = nil
          omittedCount += 1
        }
      } else {
        visibleIndex = nil
      }
      if let eventTurnId, let visibleIndex {
        sourceKeysByTurn[eventTurnId, default: []].insert(key)
      }
    }
  }

  // Link detection only scans assistant text in turns that actually have
  // visible sources. Fragments sharing an item and phase are joined first so
  // a URL split across streaming deltas is still recognized.
  for envelope in orderedTranscript {
    guard case .assistantText(let text, let rawTurnId, let itemId) = envelope.event,
          let turnId = normalizedWorkTurnId(rawTurnId),
          let sourceKeys = sourceKeysByTurn[turnId], !sourceKeys.isEmpty else { continue }
    let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let phase = envelope.textPhase?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    let messageKey = normalizedItemId.isEmpty
      ? envelope.id
      : "\(envelope.sessionId):\(turnId):\(normalizedItemId):\(phase)"
    if let current = proseByMessage[messageKey] {
      proseByMessage[messageKey] = (current.turnId, current.text + text)
    } else {
      proseByMessage[messageKey] = (turnId, text)
    }
  }

  for (_, prose) in proseByMessage {
    guard let turnId = prose.turnId, let sourceKeys = sourceKeysByTurn[turnId] else { continue }
    for linkedKey in workLinkedSourceUrls(in: prose.text) where sourceKeys.contains(linkedKey) {
      guard let index = indexByKey[linkedKey] else { continue }
      refs[index].cited = true
    }
  }
  var countsByTurn = allSourceKeysByTurn.mapValues(\.count)
  for (turnId, omitted) in omittedByTurn {
    countsByTurn[turnId, default: 0] += omitted
  }
  return WorkChatSourceList(refs: refs, omittedCount: omittedCount, countsByTurn: countsByTurn)
}
