import Foundation

/// Display-only mirror of desktop shared/secretRedaction.ts. Never use for execution or transport.
private enum WorkCommandRedaction {
  static func regex(_ pattern: String, insensitive: Bool = false) -> NSRegularExpression {
    // Patterns are fixed, code-owned constants, compiled once.
    try! NSRegularExpression(pattern: pattern, options: insensitive ? [.caseInsensitive] : [])
  }
  static let privateKey = regex(#"-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)"#)
  static let url = regex(#"(\b[a-z][a-z0-9+.-]{0,31}://[^\s:/@"']+:)[^\s@/"']+@"#, insensitive: true)
  static let authorization = regex(#"(\b(?:proxy-)?authorization["']?\s*[:=]\s*)(["']?)((?:(?:bearer|basic|token)\s+)?)([^\s"',;]+)"#, insensitive: true)
  static let bearer = regex(#"(\bbearer\s+)[A-Za-z0-9\-._~+/]{12,}=*"#, insensitive: true)
  static let assignment = regex(#"(\b(?:[A-Z][A-Z0-9]{0,31}_){0,8}(?:[A-Z0-9]{0,31}(?:TOKEN|SECRET|PASSWORD|PASSWD)|(?:API)?KEY|CREDENTIALS?|AUTH_CONFIG|AUTH_HEADER|AUTHORIZATION)[ \t]*=(?!=)[ \t]*)((?:"(?:\\.|[^"\\\n])+"|'(?:\\.|[^'\\\n])+'|(?![$%<{])(?:\\.|[^\s"'&;|)<>\\])+))"#)
  static let json = regex(#"(\\?["'][A-Za-z0-9_.-]*(?:key|token|secret|password|passwd)\\?["']\s*:\s*)(\\?["'])((?:\\.|[^"'\\\n])+?)\2"#, insensitive: true)
  static let flag = regex(#"(--(?:[a-z0-9]{1,32}[-_]){0,8}(?:[a-z0-9]{0,31}(?:token|secret|passw(?:or)?d)|(?:api)?key|credentials?)(?:=|\s+(?!-)))((?:"(?:\\.|[^"\\\n])+"|'(?:\\.|[^'\\\n])+'|(?![$%<{])(?:\\.|[^\s"'&;|)<>\\])+))"#)
  static let tokens = [
    regex(#"\bsk-ant-[A-Za-z0-9_-]*|\bsk-[A-Za-z0-9_-]{12,}"#),
    regex(#"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"#),
    regex(#"\bgithub_pat_[A-Za-z0-9_]{20,}"#),
    regex(#"\bxox[abposr]-[A-Za-z0-9-]{10,}"#),
    regex(#"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"#),
    regex(#"\bAIza[0-9A-Za-z_-]{35}"#),
    regex(#"\bglpat-[A-Za-z0-9_-]{20,}"#),
    regex(#"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}"#),
    regex(#"\blin_api_[A-Za-z0-9]{20,}"#),
    regex(#"\bnpm_[A-Za-z0-9]{30,}"#),
    regex(#"\bhf_[A-Za-z0-9]{30,}"#),
    regex(#"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"#),
  ]
  static let escapes = regex(#"\\[\s\S]"#)
  static let placeholder = regex(#"^"?(?:[<%]|\{\w+\})"#)
  static let singlePlaceholder = regex(#"^'<[^<>'\n]*>'$"#)

  static func replace(_ input: String, _ pattern: NSRegularExpression,
                      _ replacement: ([String], Int, NSString) -> String) -> String {
    let source = input as NSString
    let result = NSMutableString(string: input)
    for match in pattern.matches(in: input, range: NSRange(location: 0, length: source.length)).reversed() {
      let groups = (0..<match.numberOfRanges).map { index -> String in
        let range = match.range(at: index)
        return range.location == NSNotFound ? "" : source.substring(with: range)
      }
      result.replaceCharacters(in: match.range, with: replacement(groups, match.range.location, source))
    }
    return result as String
  }

  static func isPlaceholder(_ value: String) -> Bool {
    placeholder.firstMatch(in: value, range: NSRange(location: 0, length: (value as NSString).length)) != nil
  }

  static func staysVisible(_ value: String) -> Bool {
    if value.hasPrefix("'") {
      return singlePlaceholder.firstMatch(in: value, range: NSRange(location: 0, length: (value as NSString).length)) != nil
    }
    if isPlaceholder(value) { return true }
    let unescaped = replace(value, escapes) { _, _, _ in "" }
    return unescaped.contains("$") || unescaped.contains("`")
  }
}

func workRedactCommandLine(_ command: String) -> String {
  typealias R = WorkCommandRedaction
  var out = R.replace(command, R.privateKey) { _, _, _ in "<redacted-private-key>" }
  out = R.replace(out, R.url) { groups, _, _ in groups[1] + "<redacted>@" }
  for pattern in R.tokens {
    out = R.replace(out, pattern) { _, _, _ in "<redacted-token>" }
  }
  out = R.replace(out, R.authorization) { groups, offset, source in
    let singleQuoted = groups[2] == "'" || (offset > 0 && source.substring(with: NSRange(location: offset - 1, length: 1)) == "'")
    let value = singleQuoted ? "'" + groups[4] + "'" : groups[2] + groups[4]
    return R.staysVisible(value) ? groups[0] : groups[1] + groups[2] + groups[3] + "<redacted>"
  }
  out = R.replace(out, R.bearer) { groups, _, _ in groups[1] + "<redacted>" }
  out = R.replace(out, R.assignment) { groups, _, _ in
    groups[1] + (R.staysVisible(groups[2]) ? groups[2] : "<redacted>")
  }
  out = R.replace(out, R.json) { groups, _, _ in
    let visible = groups[2].hasPrefix("\\") ? R.staysVisible("\"" + groups[3] + "\"") : R.isPlaceholder(groups[3])
    return visible ? groups[0] : groups[1] + groups[2] + "<redacted>" + groups[2]
  }
  return R.replace(out, R.flag) { groups, _, _ in
    groups[1] + (R.staysVisible(groups[2]) ? groups[2] : "<redacted>")
  }
}


/// Masks only the command/cmd fields of shell-tool arguments for display.
func workMaskShellCommandArgsText(tool: String, argsText: String) -> String {
  guard workIsShellToolName(tool) || tool == "Monitor" else { return argsText }
  guard let data = argsText.data(using: .utf8),
        var object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  else { return workRedactCommandLine(argsText) }
  var changed = false
  for key in ["command", "cmd"] {
    if let value = object[key] as? String {
      let masked = workRedactCommandLine(value)
      if masked != value { object[key] = masked; changed = true }
    } else if let array = object[key] as? [Any] {
      let values = array.map { value -> String in
        if let string = value as? String { return string }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]),
              let string = String(data: data, encoding: .utf8) else { return "null" }
        return string
      }
      let joined = values.joined(separator: "\n")
      let masked = workRedactCommandLine(joined)
      if masked != joined {
        let parts = masked.components(separatedBy: "\n")
        object[key] = parts.count == values.count ? parts : values.map(workRedactCommandLine)
        changed = true
      }
    }
  }
  guard changed, let output = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let text = String(data: output, encoding: .utf8) else { return argsText }
  return text
}
