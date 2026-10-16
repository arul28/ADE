import Foundation

// Reading a computer-use command's output: the element hit, the effect, the
// key/value rows, the windows footer, errors, the user's browser, and the
// proof ids it filed. A port of
// `apps/desktop/src/shared/computerUseActionOutput.ts`; keep them in step. The
// command parsing and the summary it feeds live in `WorkComputerUseSummary.swift`.

// MARK: - Output parsing

struct CUOutput {
  var hitName: String?
  var hitNone = false
  var effect: String?
  var effectReason: String?
  var values: [String: String] = [:]
  var windows: [(id: String, app: String)] = []
  var errorMessage: String?
  var okFalse = false
  var openedUrl: String?
  var json: [String: Any]?
  /// `attached: …` (or the JSON attach result); "" when only the flag was seen.
  var attachedLine: String?
  /// `target: …` (or JSON `userBrowserTarget`): "your Google Chrome on studio-mac".
  var userBrowserTarget: String?
  var prNumber: Int?
  /// Proof ids the output says it filed: `cite: ![…](ade-proof://<id>)`, the
  /// JSON record, or the filed table above an `Attached N artifact(s) to …`
  /// line (a trace or a log gets no `cite:` line).
  var proofIds: [String] = []
  /// Ids a `proof publish` reports as posted (`  posted  <id>  …`, JSON `posted[]`).
  var postedProofIds: [String] = []
}

private let cuProofIdText = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"

func cuReadString(_ value: Any?) -> String? {
  guard let text = value as? String else { return nil }
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}

private func cuQuotedName(_ text: String) -> String? {
  guard let start = text.firstIndex(of: "\"") else { return nil }
  var index = text.index(after: start)
  while index < text.endIndex {
    let char = text[index]
    if char == "\\" {
      index = text.index(index, offsetBy: 2, limitedBy: text.endIndex) ?? text.endIndex
      continue
    }
    if char == "\"" { break }
    index = text.index(after: index)
  }
  let literal = String(text[start..<(index < text.endIndex ? text.index(after: index) : text.endIndex)])
  if let data = "[\(literal)]".data(using: .utf8),
     let array = try? JSONSerialization.jsonObject(with: data) as? [String],
     let first = array.first?.trimmingCharacters(in: .whitespacesAndNewlines), !first.isEmpty {
    return first
  }
  let raw = String(text[text.index(after: start)..<index]).trimmingCharacters(in: .whitespaces)
  return raw.isEmpty ? nil : raw
}

private func cuElementName(_ element: [String: Any]?) -> String? {
  guard let element else { return nil }
  for key in ["title", "label", "text", "name", "value", "placeholder", "identifier", "ariaLabel"] {
    if let value = cuReadString(element[key]) { return value }
  }
  return nil
}

private func cuParseJSON(_ output: String) -> [String: Any]? {
  let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
  guard let start = trimmed.firstIndex(of: "{"),
        trimmed.distance(from: trimmed.startIndex, to: start) <= 200,
        let end = trimmed.lastIndex(of: "}"), end > start,
        let data = String(trimmed[start...end]).data(using: .utf8),
        let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
  if parsed["domain"] is String, let inner = parsed["result"] as? [String: Any] { return inner }
  return parsed
}

func cuParseOutput(_ output: String) -> CUOutput {
  var parsed = CUOutput()
  guard !output.isEmpty else { return parsed }
  var tableIds: [String] = []
  var filedConfirmed = false
  for rawLine in output.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
    let line = rawLine.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    let lower = trimmed.lowercased()
    if lower.hasPrefix("hit:"), parsed.hitName == nil, !parsed.hitNone {
      let rest = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespaces)
      if rest.lowercased().hasPrefix("no element") { parsed.hitNone = true } else { parsed.hitName = cuQuotedName(rest) }
      continue
    }
    if lower.hasPrefix("effect:"), parsed.effect == nil {
      let rest = String(trimmed.dropFirst(7)).trimmingCharacters(in: .whitespaces)
      let parts = cuSplit(#"\s+—\s+|\s+-\s+"#, rest)
      let status = (parts.first ?? "").lowercased()
      if status.hasPrefix("observed") { parsed.effect = "observed" }
      else if status.hasPrefix("unconfirmed") { parsed.effect = "unconfirmed" }
      else if status.hasPrefix("waiting") { parsed.effect = "waiting" }
      else if status.hasPrefix("not checked") || status.hasPrefix("not_checked") { parsed.effect = "not_checked" }
      let reason = parts.dropFirst().joined(separator: " — ").trimmingCharacters(in: .whitespaces)
      parsed.effectReason = reason.isEmpty ? nil : reason
      continue
    }
    if parsed.errorMessage == nil, cuTests(#"^ade:\s"#, trimmed) {
      let message = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: #"^[A-Z][A-Z0-9_]{3,}:\s*"#, with: "", options: .regularExpression)
      parsed.errorMessage = message.isEmpty ? nil : message
      continue
    }
    if lower.hasPrefix(workUserBrowserAttachedPrefix), parsed.attachedLine == nil {
      parsed.attachedLine = String(trimmed.dropFirst(workUserBrowserAttachedPrefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
      continue
    }
    if lower.hasPrefix(workUserBrowserTargetPrefix), parsed.userBrowserTarget == nil {
      parsed.userBrowserTarget = String(trimmed.dropFirst(workUserBrowserTargetPrefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
      continue
    }
    if parsed.openedUrl == nil, let opened = cuMatch(#"^(?:opened|navigated):\s+\S+\s+(\S+)"#, trimmed, [.caseInsensitive]), let url = opened[1] {
      parsed.openedUrl = url
      continue
    }
    if let posted = cuMatch("^posted\\s+(\(cuProofIdText))\\b", trimmed, [.caseInsensitive])?[1] ?? nil,
       !parsed.postedProofIds.contains(posted) {
      parsed.postedProofIds.append(posted)
    }
    if let tableId = cuMatch("^(\(cuProofIdText))\\s+\\S", trimmed)?[1] ?? nil { tableIds.append(tableId) }
    if cuTests(#"^attached \d+ artifacts? to\b"#, trimmed, [.caseInsensitive]) { filedConfirmed = true }
    if parsed.prNumber == nil, lower.hasPrefix("posted"), let pr = cuMatch(#"/pull/(\d+)\b"#, trimmed)?[1] ?? nil {
      parsed.prNumber = Int(pr)
    }
    if let window = cuMatch(#"^\s+#(\d+)\s+(.+?)(?:\s+—\s+(.*))?$"#, line), let id = window[1], let app = window[2] {
      parsed.windows.append((id: id, app: app.trimmingCharacters(in: .whitespaces)))
      continue
    }
    if let kv = cuMatch(#"^([a-z][a-z0-9 ]{0,30}?)\s{2,}(\S.*)$"#, trimmed), let key = kv[1], let value = kv[2], parsed.values[key] == nil {
      parsed.values[key] = value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }
  if parsed.values["ok"] == "false" { parsed.okFalse = true }
  if let regex = WorkCURegexCache.shared.regex(#"ade-proof:/{0,2}([\w-]+)"#, [.caseInsensitive]) {
    for match in regex.matches(in: output, range: NSRange(output.startIndex..., in: output)) {
      if let range = Range(match.range(at: 1), in: output), !parsed.proofIds.contains(String(output[range])) {
        parsed.proofIds.append(String(output[range]))
      }
    }
  }
  if filedConfirmed {
    for id in tableIds where !parsed.proofIds.contains(id) { parsed.proofIds.append(id) }
  }
  if let json = cuParseJSON(output) {
    parsed.json = json
    let match = json["match"] as? [String: Any]
    let resolved = (json["resolved"] as? [String: Any]) ?? (json["matched"] as? [String: Any]) ?? (match?["element"] as? [String: Any])
    if parsed.hitName == nil { parsed.hitName = cuElementName(resolved) }
    if parsed.effect == nil, let effect = json["effect"] as? [String: Any], let status = cuReadString(effect["status"]) {
      parsed.effect = ["observed", "unconfirmed", "not_checked"].contains(status) ? status : (status == "waiting_for_approval" ? "waiting" : nil)
      parsed.effectReason = cuReadString(effect["reason"])
    }
    if (json["ok"] as? Bool) == false { parsed.okFalse = true }
    if parsed.errorMessage == nil {
      parsed.errorMessage = cuReadString(json["error"]) ?? cuReadString((json["error"] as? [String: Any])?["message"])
    }
    if (json["attached"] as? Bool) == true || cuReadString(json["browserKind"]) == "user" || json["attached"] is [String: Any] {
      parsed.attachedLine = parsed.attachedLine ?? cuReadString((json["attached"] as? [String: Any])?["label"]) ?? ""
    }
    if parsed.userBrowserTarget == nil { parsed.userBrowserTarget = cuReadString(json["userBrowserTarget"]) }
    for entry in (json["posted"] as? [Any]) ?? [] {
      if let id = cuReadString((entry as? [String: Any])?["id"]), !parsed.postedProofIds.contains(id) {
        parsed.postedProofIds.append(id)
      }
    }
    let nested = [json["artifact"] as? [String: Any]] + ((json["artifacts"] as? [Any]) ?? []).map { $0 as? [String: Any] }
    for (index, record) in ([json as [String: Any]?] + nested).enumerated() {
      let id = cuReadString(record?["proofArtifactId"]) ?? cuReadString(record?["artifactId"])
        ?? (index == 0 ? nil : cuReadString(record?["id"]))
      if let id, !parsed.proofIds.contains(id) { parsed.proofIds.append(id) }
    }
  }
  return parsed
}

// MARK: - Field readers

func cuClip(_ value: String, _ max: Int = 60) -> String {
  let oneLine = value.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
  return oneLine.count > max ? "\(oneLine.prefix(max - 1))…" : oneLine
}

func cuUrlHost(_ value: String?) -> String? {
  guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
  let withScheme = cuTests(#"^[a-z][a-z0-9+.-]*://"#, raw, [.caseInsensitive]) ? raw : "http://\(raw)"
  guard let components = URLComponents(string: withScheme), let host = components.host?.lowercased(), !host.isEmpty else { return nil }
  let scheme = components.scheme?.lowercased()
  if scheme == "about" || scheme == "data" { return nil }
  // Like a WHATWG URL's `host`: the default port is not part of it.
  if let port = components.port, !((scheme == "http" && port == 80) || (scheme == "https" && port == 443)) { return "\(host):\(port)" }
  return host
}

// These mirror `apps/desktop/src/shared/userBrowserLabels.ts`: the browsers
// `ade browser attach` can reach, their short names, and the line prefixes.
private let workUserBrowserIds = ["chrome", "edge", "brave", "arc", "helium", "chromium"]
private let workUserBrowserShortNames: [String: String] = [
  "chrome": "Chrome", "edge": "Edge", "brave": "Brave", "arc": "Arc", "helium": "Helium", "chromium": "Chromium",
]
private let workUserBrowserAttachedPrefix = "attached:"
private let workUserBrowserTargetPrefix = "target:"

/// "Google Chrome" → "Chrome": the short name of the first browser the text names.
private func cuUserBrowserShortName(_ text: String?) -> String? {
  guard let text, !text.isEmpty else { return nil }
  for id in workUserBrowserIds where cuTests("\\b\(id)\\b", text, [.caseInsensitive]) {
    return workUserBrowserShortNames[id]
  }
  return nil
}

/// The user's own browser, when the output says the command reached it (desktop `readUserBrowser`).
func cuReadUserBrowser(_ parsed: CUOutput) -> (browser: String?, host: String?)? {
  let target = parsed.userBrowserTarget.flatMap { cuMatch(#"^your\s+(.+?)\s+on\s+(.+?)$"#, $0, [.caseInsensitive]) }
  guard parsed.attachedLine != nil || target != nil else { return nil }
  let attached = parsed.attachedLine.flatMap { $0.isEmpty ? nil : cuMatch(#"^(.+?)\s+on\s+(.+?)(?:,\s*tab\b.*)?$"#, $0, [.caseInsensitive]) }
  let source = (target?[1] ?? nil) ?? (attached?[1] ?? nil) ?? (parsed.attachedLine?.isEmpty == false ? parsed.attachedLine : nil)
  let browser = cuUserBrowserShortName(source)
    ?? cuUserBrowserShortName(parsed.values["browser"])
    ?? cuUserBrowserShortName(cuReadString(parsed.json?["browserLabel"]))
    ?? cuUserBrowserShortName(cuReadString(parsed.json?["browser"]))
  let host = (target?[2] ?? nil) ?? (attached?[2] ?? nil)
    ?? parsed.values["machine"] ?? parsed.values["host"] ?? cuReadString(parsed.json?["machine"])
  return (browser, host.map { cuClip($0, 40) })
}
